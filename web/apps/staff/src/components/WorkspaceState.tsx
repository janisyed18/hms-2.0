import { AlertCircle, CheckCircle2, Inbox, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

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
    <section className={`workspace-state state-${tone}`} aria-live="polite">
      <Icon aria-hidden="true" className={tone === "loading" ? "is-spinning" : ""} size={22} />
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
      {action ? <div className="workspace-state-action">{action}</div> : null}
    </section>
  );
}

export function SourceBadge({ source }: { source: "api" | "mock" }) {
  return (
    <span className={`source-badge source-${source}`}>
      {source === "api" ? "Backend" : "Mock data"}
    </span>
  );
}
