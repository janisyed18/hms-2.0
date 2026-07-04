import { AppShell } from "./components/AppShell";
import { InspectionCapture } from "./components/InspectionCapture";
import { ScanUnavailable } from "./components/ScanUnavailable";
import { SyncQueue } from "./components/SyncQueue";
import { WorkQueue } from "./components/WorkQueue";
import { useInspectorWorkspace } from "./hooks/useInspectorWorkspace";

export default function App() {
  const workspace = useInspectorWorkspace();
  const sourceLabel =
    workspace.source === "api" ? workspace.lastSyncLabel : "Mock data loaded";

  let content;

  if (workspace.view === "capture") {
    content = (
      <InspectionCapture
        onBack={() => workspace.setView("work")}
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
