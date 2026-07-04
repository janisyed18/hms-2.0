import {
  BriefcaseBusiness,
  Cloud,
  QrCode,
  RefreshCw,
  ShieldCheck
} from "lucide-react";
import type { ReactNode } from "react";
import type { InspectorView } from "../hooks/useInspectorWorkspace";

interface AppShellProps {
  view: InspectorView;
  isOnline: boolean;
  queuedCount: number;
  sourceLabel: string;
  children: ReactNode;
  onNavigate: (view: InspectorView) => void;
}

const navItems: Array<{
  view: InspectorView;
  label: string;
  icon: typeof BriefcaseBusiness;
}> = [
  { view: "work", label: "Work", icon: BriefcaseBusiness },
  { view: "capture", label: "Capture", icon: ShieldCheck },
  { view: "queue", label: "Queue", icon: Cloud },
  { view: "scan", label: "Scan", icon: QrCode }
];

export function AppShell({
  view,
  isOnline,
  queuedCount,
  sourceLabel,
  children,
  onNavigate
}: AppShellProps) {
  return (
    <div className="inspector-stage">
      <div className="inspector-device">
        <header className="app-header">
          <div>
            <p className="eyebrow">BAT HMS</p>
            <h1>BAT Inspector</h1>
          </div>
          <div className="header-status" aria-label="Sync status">
            <span className={isOnline ? "live-dot" : "live-dot live-dot--off"} />
            <span>{isOnline ? "Online" : "Offline"}</span>
          </div>
        </header>

        <div className="sync-strip">
          <span>{sourceLabel}</span>
          <span>
            <RefreshCw aria-hidden="true" size={14} />
            {queuedCount} queued
          </span>
        </div>

        <div className="app-content">{children}</div>

        <nav className="bottom-nav" aria-label="Inspector navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const selected = item.view === view;
            const label =
              item.view === "queue" && queuedCount > 0
                ? `${item.label} ${queuedCount}`
                : item.label;

            return (
              <button
                aria-label={item.label}
                className={selected ? "nav-button nav-button--active" : "nav-button"}
                key={item.view}
                onClick={() => onNavigate(item.view)}
                type="button"
              >
                <Icon aria-hidden="true" size={19} />
                <span>{item.label}</span>
                {item.view === "queue" && queuedCount > 0 ? (
                  <strong aria-label={`${queuedCount} queued operations`}>
                    {queuedCount}
                  </strong>
                ) : null}
                <span className="sr-only">{label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
