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
  /** Controls placed at the end of the status area (the notification bell). */
  headerActions?: ReactNode;
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
  headerActions,
  onNavigate
}: AppShellProps) {
  return (
    <div className="inspector-app">
      <header className="app-header">
        <div className="app-header-brand">
          <div className="inspector-logo-frame">
            <img
              alt="Momentum"
              className="inspector-logo"
              height="500"
              src="/brand/momentum-logo.png"
              width="500"
            />
          </div>
          <div>
            <p className="eyebrow">Hose Management System</p>
            <h1>Inspector</h1>
          </div>
        </div>
        <div className="header-status" aria-label="Sync status">
          <span className="header-status__state">
            <span className={isOnline ? "live-dot" : "live-dot live-dot--off"} />
            <span>{isOnline ? "Online" : "Offline"}</span>
          </span>
          <span className="header-status__source">{sourceLabel}</span>
          <span className="header-status__queued">
            <RefreshCw aria-hidden="true" size={14} />
            {queuedCount} queued
          </span>
          {headerActions}
        </div>
      </header>

      <nav className="app-nav" aria-label="Inspector navigation">
        {navItems.map((item) => {
          const Icon = item.icon;
          const selected = item.view === view;
          const label =
            item.view === "queue" && queuedCount > 0
              ? `${item.label} ${queuedCount}`
              : item.label;

          return (
            <button
              aria-current={selected ? "page" : undefined}
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

      <main className="app-content">{children}</main>
    </div>
  );
}
