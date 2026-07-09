import {
  BarChart3,
  Bell,
  Boxes,
  CalendarClock,
  ChevronDown,
  ClipboardCheck,
  Database,
  FileClock,
  FileCheck2,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Plus,
  RefreshCcw,
  Search,
  ShieldCheck,
  Smartphone,
  TableProperties,
  UserCog,
  UsersRound,
  X,
  type LucideIcon
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { StaffSession } from "../domain/types";

export type AppModule =
  | "dashboard"
  | "analytics"
  | "customers"
  | "assets"
  | "products"
  | "reference"
  | "inspections"
  | "certificates"
  | "retest"
  | "sync"
  | "audit"
  | "users"
  | "devices";

type TopbarMenu = "environment" | "notifications" | "help" | "user";

interface NavItem {
  label: string;
  icon: LucideIcon;
  module: AppModule;
  badge?: string;
}

interface AppShellProps {
  activeModule: AppModule;
  canCreateAsset: boolean;
  children: ReactNode;
  description: string;
  onModuleChange: (module: AppModule) => void;
  session: StaffSession;
  source: "api" | "mock";
  title: string;
  visibleModules: AppModule[];
}

const navGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", icon: LayoutDashboard, module: "dashboard" },
      { label: "Analytics", icon: BarChart3, module: "analytics" }
    ]
  },
  {
    label: "Operations",
    items: [
      { label: "Assets", icon: Database, module: "assets", badge: "1,247" },
      { label: "Inspections", icon: ClipboardCheck, module: "inspections", badge: "8" },
      { label: "Certificates", icon: FileCheck2, module: "certificates" },
      { label: "Retest Schedule", icon: CalendarClock, module: "retest", badge: "23" },
      { label: "Sync Queue", icon: RefreshCcw, module: "sync", badge: "7" }
    ]
  },
  {
    label: "Management",
    items: [
      { label: "Customers", icon: UsersRound, module: "customers" },
      { label: "Products", icon: Boxes, module: "products" },
      { label: "Reference Data", icon: TableProperties, module: "reference" }
    ]
  },
  {
    label: "System",
    items: [
      { label: "Users & Roles", icon: UserCog, module: "users" },
      { label: "Devices", icon: Smartphone, module: "devices" },
      { label: "Audit Log", icon: FileClock, module: "audit" }
    ]
  }
];

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

function popoverCloseLabel(menu: TopbarMenu) {
  return `Close ${popoverTitle(menu).toLowerCase()}`;
}

function popoverBody(menu: TopbarMenu, source: "api" | "mock", session: StaffSession) {
  if (menu === "environment") {
    return source === "api" ? "Backend connection active." : "Demo mode uses local mock data.";
  }
  if (menu === "notifications") {
    return "Inspection approval, certificate issue, and sync queue items are ready for review.";
  }
  if (menu === "help") {
    return "Support, release notes, and workflow guidance.";
  }
  return `${session.displayName}. ${session.roles.join(", ")} workspace.`;
}

function initialsFor(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return initials || "HM";
}

export function AppShell({
  activeModule,
  canCreateAsset,
  children,
  description,
  onModuleChange,
  session,
  source,
  title,
  visibleModules
}: AppShellProps) {
  const [openMenu, setOpenMenu] = useState<TopbarMenu | null>(null);
  const [globalQuery, setGlobalQuery] = useState("");
  const visibleModuleSet = new Set(visibleModules);
  const visibleNavGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => visibleModuleSet.has(item.module))
    }))
    .filter((group) => group.items.length > 0);
  const visibleNavItems = visibleNavGroups.flatMap((group) => group.items);

  function handleGlobalSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = globalQuery.trim().toLowerCase();
    const target = visibleNavItems.find((item) =>
      item.label.toLowerCase().includes(normalized)
    );
    if (target && normalized) {
      onModuleChange(target.module);
      setGlobalQuery("");
      setOpenMenu(null);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <div className="brand-lockup">
            <div className="brand-shield">
              <ShieldCheck aria-hidden="true" size={19} />
            </div>
            <div>
              <strong>BAT HMS</strong>
              <span>v2.0</span>
            </div>
          </div>
          <form className="sidebar-search" onSubmit={handleGlobalSearch}>
            <Search aria-hidden="true" size={16} />
            <label className="sr-only" htmlFor="sidebar-search-input">
              Search assets and customers
            </label>
            <input
              id="sidebar-search-input"
              placeholder="Search assets, customers..."
              value={globalQuery}
              onChange={(event) => setGlobalQuery(event.target.value)}
            />
            <kbd>⌘K</kbd>
          </form>
        </div>
        <nav className="nav-list">
          {visibleNavGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => {
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
                    {item.badge ? (
                      <span aria-hidden="true" className="nav-badge">
                        {item.badge}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="avatar">{initialsFor(session.displayName)}</div>
          <div>
            <strong>{session.displayName}</strong>
            <span>{session.roles.join(", ")}</span>
          </div>
          <LogOut aria-hidden="true" size={17} />
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          <div className="topbar-actions">
            <form className="global-search" onSubmit={handleGlobalSearch}>
              <Search aria-hidden="true" className="global-search-icon" size={17} />
              <label className="sr-only" htmlFor="global-search-input">
                Global search
              </label>
              <input
                id="global-search-input"
                placeholder="Search customers, assets, inspections..."
                value={globalQuery}
                onChange={(event) => setGlobalQuery(event.target.value)}
              />
              <button
                aria-label="Run global search"
                className="search-submit"
                disabled={!globalQuery.trim()}
                type="submit"
              >
                <Search aria-hidden="true" size={15} />
              </button>
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
            {canCreateAsset ? (
              <button
                className="primary-button topbar-primary"
                onClick={() => onModuleChange("assets")}
                type="button"
              >
                <Plus aria-hidden="true" size={17} />
                New Asset
              </button>
            ) : null}
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
              <div className="avatar">{initialsFor(session.displayName)}</div>
              <div>
                <strong>{session.displayName}</strong>
                <span>{session.roles.join(", ")}</span>
              </div>
              <ChevronDown aria-hidden="true" size={15} />
            </button>
          </div>
          {openMenu ? (
            <div className="topbar-popover" role="dialog" aria-label={popoverTitle(openMenu)}>
              <div className="topbar-popover-header">
                <strong>{popoverTitle(openMenu)}</strong>
                <button
                  aria-label={popoverCloseLabel(openMenu)}
                  className="icon-button light"
                  onClick={() => setOpenMenu(null)}
                  type="button"
                >
                  <X size={16} />
                </button>
              </div>
              <p>{popoverBody(openMenu, source, session)}</p>
            </div>
          ) : null}
        </header>
        {children}
      </div>
    </div>
  );
}
