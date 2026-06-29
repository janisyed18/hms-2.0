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
import { useState, type FormEvent, type ReactNode } from "react";

export type AppModule =
  | "dashboard"
  | "customers"
  | "assets"
  | "products"
  | "reference"
  | "inspections"
  | "certificates"
  | "sync"
  | "audit";

type TopbarMenu = "environment" | "notifications" | "help" | "user";

interface AppShellProps {
  activeModule: AppModule;
  children: ReactNode;
  description: string;
  onModuleChange: (module: AppModule) => void;
  source: "api" | "mock";
  title: string;
}

const navItems = [
  { label: "Dashboard", icon: LayoutDashboard, module: "dashboard" },
  { label: "Customers", icon: UsersRound, module: "customers" },
  { label: "Assets", icon: Database, module: "assets" },
  { label: "Products", icon: Boxes, module: "products" },
  { label: "Reference Data", icon: TableProperties, module: "reference" },
  { label: "Inspections", icon: ClipboardCheck, module: "inspections" },
  { label: "Certificates", icon: FileCheck2, module: "certificates" },
  { label: "Sync Queue", icon: RefreshCcw, module: "sync", badge: "7" },
  { label: "Audit", icon: ShieldCheck, module: "audit" }
] satisfies Array<{
  label: string;
  icon: typeof LayoutDashboard;
  module: AppModule;
  badge?: string;
}>;

function popoverTitle(menu: TopbarMenu) {
  if (menu === "environment") {
    return "Environment details";
  }
  if (menu === "notifications") {
    return "Notifications";
  }
  if (menu === "help") {
    return "Help";
  }
  return "User menu";
}

function popoverBody(menu: TopbarMenu, source: "api" | "mock") {
  if (menu === "environment") {
    return source === "api" ? "Backend connection active." : "Demo mode uses local mock data.";
  }
  if (menu === "notifications") {
    return "Inspection approval, certificate issue, and sync queue items are ready for review.";
  }
  if (menu === "help") {
    return "Support, release notes, and workflow guidance.";
  }
  return "Alex Williams. Administrator workspace.";
}

export function AppShell({
  activeModule,
  children,
  description,
  onModuleChange,
  source,
  title
}: AppShellProps) {
  const [openMenu, setOpenMenu] = useState<TopbarMenu | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");

  function handleGlobalSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = globalQuery.trim().toLowerCase();
    const target = navItems.find((item) => item.label.toLowerCase().includes(normalized));
    if (target && normalized) {
      onModuleChange(target.module);
      setGlobalQuery("");
      setOpenMenu(null);
    }
  }

  return (
    <div className={`app-shell${isCollapsed ? " is-sidebar-collapsed" : ""}`}>
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
                  onModuleChange(item.module);
                  setOpenMenu(null);
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
        <button
          aria-expanded={!isCollapsed}
          className="collapse-button"
          onClick={() => setIsCollapsed((current) => !current)}
          type="button"
        >
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
            <form className="global-search" onSubmit={handleGlobalSearch}>
              <Search aria-hidden="true" size={17} />
              <label className="sr-only" htmlFor="global-search-input">
                Global search
              </label>
              <input
                id="global-search-input"
                placeholder="Search customers, assets, inspections..."
                value={globalQuery}
                onChange={(event) => setGlobalQuery(event.target.value)}
              />
              <kbd>/</kbd>
            </form>
            <button
              aria-label="Environment and source details"
              className="environment-button"
              onClick={() =>
                setOpenMenu(openMenu === "environment" ? null : "environment")
              }
              type="button"
            >
              <span className="status-dot" />
              <span>Live Environment</span>
              <ChevronDown aria-hidden="true" size={15} />
            </button>
            <button
              className="icon-button has-count"
              aria-label="Notifications"
              onClick={() =>
                setOpenMenu(openMenu === "notifications" ? null : "notifications")
              }
              type="button"
            >
              <Bell size={18} />
              <span>3</span>
            </button>
            <button
              className="icon-button"
              aria-label="Help"
              onClick={() => setOpenMenu(openMenu === "help" ? null : "help")}
              type="button"
            >
              <HelpCircle size={18} />
            </button>
            <button
              aria-label="User menu"
              className="user-menu"
              onClick={() => setOpenMenu(openMenu === "user" ? null : "user")}
              type="button"
            >
              <div className="avatar">AW</div>
              <div>
                <strong>Alex Williams</strong>
                <span>{source === "api" ? "Administrator" : "Demo mode"}</span>
              </div>
              <ChevronDown aria-hidden="true" size={15} />
            </button>
          </div>
          {openMenu ? (
            <div className="topbar-popover" role="dialog" aria-label={popoverTitle(openMenu)}>
              <strong>{popoverTitle(openMenu)}</strong>
              <p>{popoverBody(openMenu, source)}</p>
            </div>
          ) : null}
        </header>
        {children}
      </div>
    </div>
  );
}
