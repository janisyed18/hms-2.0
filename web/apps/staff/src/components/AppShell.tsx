import {
  Bell,
  ChevronDown,
  ClipboardCheck,
  Database,
  FileCheck2,
  HelpCircle,
  LayoutDashboard,
  Menu,
  RefreshCcw,
  Search,
  ShieldCheck,
  UsersRound
} from "lucide-react";
import type { ReactNode } from "react";

interface AppShellProps {
  children: ReactNode;
  source: "api" | "mock";
}

const navItems = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "Customers", icon: UsersRound, active: true },
  { label: "Assets", icon: Database },
  { label: "Inspections", icon: ClipboardCheck },
  { label: "Certificates", icon: FileCheck2 },
  { label: "Sync Queue", icon: RefreshCcw, badge: "7" },
  { label: "Audit", icon: ShieldCheck }
];

export function AppShell({ children, source }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <div className="brand-mark">BAT</div>
          <div className="brand-subtitle">ENGINEERING</div>
          <div className="product-name">HMS 2.0</div>
        </div>
        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={`nav-item${item.active ? " is-active" : ""}`}
                key={item.label}
                type="button"
              >
                <Icon aria-hidden="true" size={19} strokeWidth={1.9} />
                <span>{item.label}</span>
                {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
              </button>
            );
          })}
        </nav>
        <button className="collapse-button" type="button">
          <Menu aria-hidden="true" size={18} />
          <span>Collapse</span>
        </button>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <h1>Customers</h1>
            <p>Manage customers and view hose management overview</p>
          </div>
          <div className="topbar-actions">
            <label className="global-search">
              <Search aria-hidden="true" size={17} />
              <span className="sr-only">Global search</span>
              <input placeholder="Search customers, assets, inspections..." />
              <kbd>/</kbd>
            </label>
            <button className="environment-button" type="button">
              <span className="status-dot" />
              <span>Live Environment</span>
              <ChevronDown aria-hidden="true" size={15} />
            </button>
            <button className="icon-button has-count" aria-label="Notifications" type="button">
              <Bell size={18} />
              <span>3</span>
            </button>
            <button className="icon-button" aria-label="Help" type="button">
              <HelpCircle size={18} />
            </button>
            <div className="user-menu">
              <div className="avatar">AW</div>
              <div>
                <strong>Alex Williams</strong>
                <span>{source === "api" ? "Administrator" : "Demo mode"}</span>
              </div>
              <ChevronDown aria-hidden="true" size={15} />
            </div>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
