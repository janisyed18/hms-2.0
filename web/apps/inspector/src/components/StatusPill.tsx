import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  CloudOff,
  Loader2
} from "lucide-react";
import type { ReactNode } from "react";

export type StatusTone = "success" | "warning" | "danger" | "info" | "muted";

interface StatusPillProps {
  tone: StatusTone;
  children: ReactNode;
}

const icons = {
  success: CheckCircle2,
  warning: Clock3,
  danger: AlertTriangle,
  info: Loader2,
  muted: CloudOff
};

export function StatusPill({ tone, children }: StatusPillProps) {
  const Icon = icons[tone];

  return (
    <span className={`status-pill status-pill--${tone}`}>
      <Icon aria-hidden="true" size={14} />
      {children}
    </span>
  );
}
