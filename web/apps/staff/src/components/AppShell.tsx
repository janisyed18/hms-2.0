import {
  Bell,
  Boxes,
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
  TableProperties,
  UsersRound
} from "lucide-react";
import type { ReactNode } from "react";

export type AppModule =
  | "customers"
  | "assets"
  | "products"
  | "reference"
  | "inspections"
  | "certificates";

interface AppShellProps {
  activeModule: AppModule;
  children: ReactNode;
  description: string;
  onModuleChange: (module: AppModule) => void;
  source: "api" | "mock";
  title: string;
}

const navItems = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "Customers", icon: UsersRound, module: "customers" },
  { label: "Assets", icon: Database, module: "assets" },
  { label: "Products", icon: Boxes, module: "products" },
  { label: "Reference Data", icon: TableProperties, module: "reference" },
  { label: "Inspections", icon: ClipboardCheck, module: "inspections" },
  { label: "Certificates", icon: FileCheck2, module: "certificates" },
  { label: "Sync Queue", icon: RefreshCcw, badge: "7" },
  { label: "Audit", icon: ShieldCheck }
] satisfies Array<{
  label: string;
  icon: typeof LayoutDashboard;
  module?: AppModule;
  badge?: string;
}>;

export function AppShell({
  activeModule,
  children,
  description,
  onModuleChange,
  source,
  title
}: AppShellProps) {
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
            const isActive = item.module === activeModule;
            return (
              <button
                className={`nav-item${isActive ? " is-active" : ""}`}
                key={item.label}
                onClick={() => {
                  if (item.module) {
                    onModuleChange(item.module);
                  }
                }}
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
            <h1>{title}</h1>
            <p>{description}</p>
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
