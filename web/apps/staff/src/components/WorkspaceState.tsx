import { AlertCircle, CheckCircle2, Inbox, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { PresencePanel } from "../motion/MotionPrimitives";

interface WorkspaceStateProps {
  action?: ReactNode;
  children: ReactNode;
  title: string;
  tone?: "empty" | "error" | "loading" | "success";
}

const icons = {
  empty: Inbox,
  error: AlertCircle,
  loading: Loader2,
  success: CheckCircle2
};

export function WorkspaceState({
  action,
  children,
  title,
  tone = "empty"
}: WorkspaceStateProps) {
  const Icon = icons[tone];
  return (
    <PresencePanel presenceKey={tone}>
      <section
        aria-atomic="true"
        aria-live={tone === "error" ? "assertive" : "polite"}
        className={`workspace-state state-${tone}`}
        role={tone === "error" ? "alert" : "status"}
      >
        <Icon aria-hidden="true" className={tone === "loading" ? "is-spinning" : ""} size={22} />
        <div>
          <strong>{title}</strong>
          <p>{children}</p>
        </div>
        {action ? <div className="workspace-state-action">{action}</div> : null}
      </section>
    </PresencePanel>
  );
}

export function SourceBadge({ source }: { source: "api" | "mock" }) {
  return (
    <span className={`source-badge source-${source}`}>
      {source === "api" ? "Backend" : "Mock data"}
    </span>
  );
}
