import { AppShell } from "./components/AppShell";
import { InspectionCapture } from "./components/InspectionCapture";
import { ScanUnavailable } from "./components/ScanUnavailable";
import { SyncQueue } from "./components/SyncQueue";
import { WorkQueue } from "./components/WorkQueue";
import { useInspectorWorkspace } from "./hooks/useInspectorWorkspace";
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

  let content;

  if (workspace.view === "capture") {
    content = (
      <InspectionCapture
        draftFor={workspace.draftFor}
        onBack={() => workspace.setView("work")}
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
        onOpenWorkItem={workspace.openWorkItem}
        outbox={workspace.outbox.operations}
        workItems={workspace.workItems}
      />
    );
  }

  return (
    <AppShell
      isOnline={workspace.isOnline}
      onNavigate={workspace.setView}
      queuedCount={workspace.queuedCount}
      sourceLabel={sourceLabel}
      view={workspace.view}
    >
      {content}
    </AppShell>
  );
}
