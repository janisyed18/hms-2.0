import {
  BarChart3,
  Bell,
  Boxes,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  ClipboardCheck,
  Database,
  FileClock,
  FileCheck2,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  RefreshCcw,
  Search,
  ShieldCheck,
  Smartphone,
  Moon,
  Sun,
  TableProperties,
  UserCog,
  UsersRound,
  X,
  type LucideIcon
} from "lucide-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { createHmsClient } from "../api/hmsClient";
import type { NotificationRecord, StaffSession } from "../domain/types";
import { NotificationList } from "../notifications/NotificationList";
import { BELL_ITEMS, useNotificationCenter } from "../notifications/NotificationCenterProvider";
import { motionTokens } from "../motion/motionTokens";

export type AppModule =
  | "dashboard"
  | "my-work"
  | "analytics"
  | "customers"
  | "locations"
  | "bookings"
  | "assets"
  | "products"
  | "reference"
  | "scheduling"
  | "inspections"
  | "certificates"
  | "retest"
  | "notifications"
  | "sync"
  | "audit"
  | "users"
  | "devices";

type TopbarMenu = "notifications" | "help" | "user";
type WorkspaceTheme = "dark" | "light";

export interface NavItem {
  label: string;
  icon: LucideIcon;
  module: AppModule;
}

interface AppShellProps {
  activeModule: AppModule;
  canCreateAsset: boolean;
  children: ReactNode;
  description: string;
  hideGlobalSearch?: boolean;
  navGroups?: Array<{ label: string; items: NavItem[] }>;
  /** Where "View all notifications" goes. */
  notificationModule?: AppModule;
  /** A notification was opened (and marked read): take the person to what it is about. */
  onNotificationOpen?: (notification: NotificationRecord) => void;
  onLogout?: () => void;
  onModuleChange: (module: AppModule) => void;
  onSearchRecordOpen: (suggestion: GlobalSearchSuggestion) => void;
  session: StaffSession;
  title: string;
  visibleModules: AppModule[];
}

export type GlobalSearchSuggestionKind = "asset" | "customer" | "inspection" | "product";

export interface GlobalSearchSuggestion {
  id: string;
  kind: GlobalSearchSuggestionKind;
  module: AppModule;
  title: string;
  detail: string;
  searchTerms: string[];
}

const navGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", icon: LayoutDashboard, module: "dashboard" },
      { label: "My Work", icon: ClipboardCheck, module: "my-work" },
      { label: "Analytics", icon: BarChart3, module: "analytics" }
    ]
  },
  {
    label: "Operations",
    items: [
      { label: "Assets", icon: Database, module: "assets" },
      { label: "Scheduling", icon: CalendarDays, module: "scheduling" },
      { label: "Inspections", icon: ClipboardCheck, module: "inspections" },
      { label: "Certificates", icon: FileCheck2, module: "certificates" },
      { label: "Retest Schedule", icon: CalendarClock, module: "retest" },
      { label: "Sync Queue", icon: RefreshCcw, module: "sync" }
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

function suggestionIcon(kind: GlobalSearchSuggestionKind): LucideIcon {
  if (kind === "asset") {
    return Database;
  }
  if (kind === "customer") {
    return UsersRound;
  }
  if (kind === "inspection") {
    return ClipboardCheck;
  }
  return Boxes;
}

function suggestionKindLabel(kind: GlobalSearchSuggestionKind): string {
  if (kind === "asset") return "Asset";
  if (kind === "customer") return "Customer";
  if (kind === "inspection") return "Inspection";
  return "Product";
}

function orderSuggestions(
  suggestions: GlobalSearchSuggestion[],
  query: string
): GlobalSearchSuggestion[] {
  const normalized = query.trim().toLocaleLowerCase();
  return [...suggestions]
    .sort((left, right) => {
      const leftIsPrefixMatch = left.searchTerms.some((term) =>
        term.toLocaleLowerCase().startsWith(normalized)
      );
      const rightIsPrefixMatch = right.searchTerms.some((term) =>
        term.toLocaleLowerCase().startsWith(normalized)
      );
      if (leftIsPrefixMatch !== rightIsPrefixMatch) {
        return leftIsPrefixMatch ? -1 : 1;
      }
      return left.title.localeCompare(right.title);
    })
    .slice(0, 8);
}

function popoverTitle(menu: TopbarMenu) {
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

function popoverBody(menu: TopbarMenu, session: StaffSession) {
  if (menu === "help") {
    return "Support, release notes, and workflow guidance.";
  }
  return `${accountNameFor(session)} workspace.`;
}

function accountNameFor(session: StaffSession): string {
  const source = session.displayName.trim();
  if (!source || source.includes("@")) {
    const localPart = (session.email ?? source).split("@", 1)[0] ?? "";
    const friendlyName = localPart
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`)
      .join(" ");
    return friendlyName || "HMS User";
  }
  return source;
}

function accountEmailFor(session: StaffSession): string | null {
  if (session.email) {
    return session.email;
  }
  return session.displayName.includes("@") ? session.displayName : null;
}

function roleLabel(role: string): string {
  return role
    .toLowerCase()
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function roleSummary(roles: string[]): string {
  const labels = roles.map(roleLabel);
  return labels.length > 0 ? labels.join(" · ") : "HMS User";
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

function initialWorkspaceTheme(): WorkspaceTheme {
  if (typeof window === "undefined") {
    return "dark";
  }
  try {
    return window.localStorage?.getItem("hms-workspace-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

interface SidebarNavigationProps {
  activeModule: AppModule;
  globalQuery: string;
  idSuffix: string;
  onGlobalQueryChange: (query: string) => void;
  onModuleChange: (module: AppModule) => void;
  onSearch: (event: FormEvent<HTMLFormElement>) => void;
  hideGlobalSearch: boolean;
  onSignOut: () => void;
  session: StaffSession;
  visibleNavGroups: Array<{ label: string; items: NavItem[] }>;
}

function SidebarNavigation({
  activeModule,
  globalQuery,
  idSuffix,
  onGlobalQueryChange,
  onModuleChange,
  onSearch,
  hideGlobalSearch,
  onSignOut,
  session,
  visibleNavGroups
}: SidebarNavigationProps) {
  const reducedMotion = useReducedMotion();
  const activeIndicatorTransition = reducedMotion
    ? { duration: 0 }
    : motionTokens.spring.gentle;
  const accountName = accountNameFor(session);

  return (
    <>
      <div className="brand">
        <div className="brand-lockup">
          <div className="brand-logo-frame">
            <img
              alt="Momentum"
              className="brand-logo"
              height="500"
              src="/brand/momentum-logo.png"
              width="500"
            />
          </div>
          <span className="brand-product-label">Hose Management System</span>
        </div>
        {!hideGlobalSearch ? <form className="sidebar-search" onSubmit={onSearch}>
          <Search aria-hidden="true" size={16} />
          <label className="sr-only" htmlFor={`sidebar-search-input-${idSuffix}`}>
            Search assets and customers
          </label>
          <input
            id={`sidebar-search-input-${idSuffix}`}
            placeholder="Search workspace"
            value={globalQuery}
            onChange={(event) => onGlobalQueryChange(event.target.value)}
          />
        </form> : null}
      </div>
      <nav aria-label="Primary navigation" className="nav-list">
        {visibleNavGroups.map((group) => (
          <div className="nav-group" key={group.label}>
            <span className="nav-group-label">{group.label}</span>
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = item.module === activeModule;
              return (
                <button
                  aria-current={isActive ? "page" : undefined}
                  className={`nav-item${isActive ? " is-active" : ""}`}
                  key={item.label}
                  onClick={() => onModuleChange(item.module)}
                  type="button"
                >
                  {isActive ? (
                    <m.span
                      aria-hidden="true"
                      className="nav-active-indicator"
                      layoutId={`active-navigation-${idSuffix}`}
                      transition={activeIndicatorTransition}
                    />
                  ) : null}
                  <Icon aria-hidden="true" size={18} strokeWidth={1.75} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-user">
        <div className="avatar">{initialsFor(accountName)}</div>
        <div>
          <strong>{accountName}</strong>
          <span>{roleSummary(session.roles)}</span>
        </div>
        <button
          aria-label="Sign out"
          className="sidebar-logout"
          onClick={onSignOut}
          type="button"
        >
          <LogOut aria-hidden="true" size={17} />
        </button>
      </div>
    </>
  );
}

export function AppShell({
  activeModule,
  canCreateAsset,
  children,
  description,
  hideGlobalSearch = false,
  navGroups: customNavGroups,
  notificationModule,
  onLogout,
  onNotificationOpen,
  onModuleChange,
  onSearchRecordOpen,
  session,
  title,
  visibleModules
}: AppShellProps) {
  const [openMenu, setOpenMenu] = useState<TopbarMenu | null>(null);
  const [isMobileNavigationOpen, setIsMobileNavigationOpen] = useState(false);
  const [theme, setTheme] = useState<WorkspaceTheme>(initialWorkspaceTheme);
  const notificationFeed = useNotificationCenter();
  const notificationBellRef = useRef<HTMLButtonElement>(null);
  const [globalQuery, setGlobalQuery] = useState("");
  const [searchSuggestions, setSearchSuggestions] = useState<GlobalSearchSuggestion[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const mobileDrawerRef = useRef<HTMLElement>(null);
  const mobileToggleRef = useRef<HTMLButtonElement>(null);
  const globalSearchRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const accountName = accountNameFor(session);
  const accountEmail = accountEmailFor(session);
  const visibleModuleSet = useMemo(() => new Set(visibleModules), [visibleModules]);
  const visibleNavGroups = useMemo(
    () =>
      (customNavGroups ?? navGroups)
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => visibleModuleSet.has(item.module))
        }))
        .filter((group) => group.items.length > 0),
    [customNavGroups, visibleModuleSet]
  );
  const visibleNavItems = useMemo(
    () => visibleNavGroups.flatMap((group) => group.items),
    [visibleNavGroups]
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage?.setItem("hms-workspace-theme", theme);
    } catch {
      // Theme persistence is optional; rendering must also work in restricted webviews.
    }
  }, [theme]);

  useEffect(() => {
    const query = globalQuery.trim();
    if (query.length < 2) {
      setSearchSuggestions([]);
      setSearchStatus("idle");
      setActiveSuggestionIndex(-1);
      return;
    }

    let isCurrent = true;
    const timeoutId = window.setTimeout(() => {
      setSearchStatus("loading");
      const client = createHmsClient();
      void Promise.all([
        visibleModuleSet.has("customers")
          ? client.listCustomers({ search: query, limit: 3, sort: "name" })
          : Promise.resolve(null),
        visibleModuleSet.has("assets")
          ? client.listAssets({ search: query, limit: 3, sort: "asset_number" })
          : Promise.resolve(null),
        visibleModuleSet.has("products")
          ? client.listProducts({ search: query, limit: 3, sort: "name" })
          : Promise.resolve(null),
        visibleModuleSet.has("inspections")
          ? client.listInspections({ search: query, limit: 3, sort: "submitted_at" })
          : Promise.resolve(null)
      ])
        .then(([customers, assets, products, inspections]) => {
          if (!isCurrent) return;
          const suggestions = orderSuggestions(
            [
              ...(customers?.items.map((customer) => ({
                id: customer.id,
                kind: "customer" as const,
                module: "customers" as const,
                title: customer.name,
                detail: customer.code,
                searchTerms: [customer.name, customer.code]
              })) ?? []),
              ...(assets?.items.map((asset) => ({
                id: asset.id,
                kind: "asset" as const,
                module: "assets" as const,
                title: asset.assetNumber,
                detail: `${asset.customer.name} · ${asset.product.name}`,
                searchTerms: [
                  asset.assetNumber,
                  asset.assetName ?? "",
                  asset.customer.name,
                  asset.product.name
                ]
              })) ?? []),
              ...(products?.items.map((product) => ({
                id: product.id,
                kind: "product" as const,
                module: "products" as const,
                title: product.name,
                detail: `${product.code} · ${product.category}`,
                searchTerms: [product.name, product.code, product.category]
              })) ?? []),
              ...(inspections?.items.map((inspection) => ({
                id: inspection.id,
                kind: "inspection" as const,
                module: "inspections" as const,
                title: inspection.asset.assetNumber,
                detail: `${inspection.inspectionType.replaceAll("_", " ")} · ${inspection.status}`,
                searchTerms: [
                  inspection.asset.assetNumber,
                  inspection.inspectionType,
                  inspection.status,
                  inspection.customer.name
                ]
              })) ?? [])
            ],
            query
          );
          setSearchSuggestions(suggestions);
          setActiveSuggestionIndex(suggestions.length > 0 ? 0 : -1);
          setSearchStatus("ready");
        })
        .catch(() => {
          if (!isCurrent) return;
          setSearchSuggestions([]);
          setActiveSuggestionIndex(-1);
          setSearchStatus("error");
        });
    }, 180);

    return () => {
      isCurrent = false;
      window.clearTimeout(timeoutId);
    };
  }, [globalQuery, visibleModuleSet]);

  useEffect(() => {
    if (!isSearchOpen) return;
    function closeSearchWhenClickedOutside(event: PointerEvent) {
      if (!globalSearchRef.current?.contains(event.target as Node)) {
        setIsSearchOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeSearchWhenClickedOutside);
    return () => document.removeEventListener("pointerdown", closeSearchWhenClickedOutside);
  }, [isSearchOpen]);

  function handleLogout() {
    setOpenMenu(null);
    setIsMobileNavigationOpen(false);
    onLogout?.();
  }

  function clearGlobalSearch() {
    setGlobalQuery("");
    setSearchSuggestions([]);
    setSearchStatus("idle");
    setIsSearchOpen(false);
    setActiveSuggestionIndex(-1);
  }
  useEffect(() => {
    if (!isMobileNavigationOpen) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const mobileToggle = mobileToggleRef.current;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    const focusable = Array.from(
      mobileDrawerRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []
    );
    focusable[0]?.focus();

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsMobileNavigationOpen(false);
        return;
      }
      if (event.key === "Tab" && focusable.length > 0) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      (previouslyFocused ?? mobileToggle)?.focus();
    };
  }, [isMobileNavigationOpen]);

  function handleModuleChange(module: AppModule) {
    onModuleChange(module);
    clearGlobalSearch();
    setOpenMenu(null);
    setIsMobileNavigationOpen(false);
  }

  function handleSearchSuggestionOpen(suggestion: GlobalSearchSuggestion) {
    clearGlobalSearch();
    onSearchRecordOpen(suggestion);
  }

  async function handleNotificationOpen(notification: NotificationRecord) {
    // Read on the server first: if that fails the person stays where they are, still unread.
    if (!(await notificationFeed.markRead(notification))) return;
    closeMenu();
    onNotificationOpen?.(notification);
  }

  async function handleMarkAllRead() {
    await notificationFeed.markAllRead();
  }

  function handleViewAllNotifications() {
    closeMenu();
    if (notificationModule) handleModuleChange(notificationModule);
  }

  // Closing a popover returns focus to the control that opened it.
  function closeMenu() {
    const wasNotifications = openMenu === "notifications";
    setOpenMenu(null);
    if (wasNotifications) notificationBellRef.current?.focus();
  }

  useEffect(() => {
    if (!openMenu) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpenMenu(null);
      if (openMenu === "notifications") notificationBellRef.current?.focus();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [openMenu]);

  function handleGlobalSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = globalQuery.trim().toLocaleLowerCase();
    const activeSuggestion = searchSuggestions[activeSuggestionIndex] ?? searchSuggestions[0];
    if (activeSuggestion && normalized.length >= 2) {
      handleSearchSuggestionOpen(activeSuggestion);
      return;
    }
    const target = visibleNavItems.find((item) =>
      item.label.toLowerCase().includes(normalized)
    );
    if (target && normalized) {
      handleModuleChange(target.module);
    }
  }

  function handleGlobalSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      clearGlobalSearch();
      event.currentTarget.blur();
      return;
    }
    if (searchSuggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIsSearchOpen(true);
      setActiveSuggestionIndex((current) =>
        current < searchSuggestions.length - 1 ? current + 1 : 0
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIsSearchOpen(true);
      setActiveSuggestionIndex((current) =>
        current > 0 ? current - 1 : searchSuggestions.length - 1
      );
    }
  }

  const drawerTransition = reducedMotion
    ? { duration: 0 }
    : { duration: motionTokens.duration.normal, ease: motionTokens.ease.enter };
  const drawerExitTransition = reducedMotion
    ? { duration: 0 }
    : { duration: motionTokens.duration.fast, ease: motionTokens.ease.exit };
  const sidebarNavigationProps = {
    activeModule,
    globalQuery,
    onGlobalQueryChange: setGlobalQuery,
    onModuleChange: handleModuleChange,
    onSearch: handleGlobalSearch,
    hideGlobalSearch,
    onSignOut: handleLogout,
    session,
    visibleNavGroups
  };

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <SidebarNavigation {...sidebarNavigationProps} idSuffix="desktop" />
      </aside>

      <AnimatePresence initial={false}>
        {isMobileNavigationOpen ? (
          <>
            <m.button
              aria-label="Close navigation menu"
              className="mobile-nav-backdrop"
              exit={{ opacity: 0, transition: drawerExitTransition }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onClick={() => setIsMobileNavigationOpen(false)}
              transition={drawerTransition}
              type="button"
            />
            <m.aside
              aria-label="Navigation menu"
              aria-modal="true"
              className="mobile-nav-drawer"
              exit={{
                x: reducedMotion ? 0 : "-100%",
                transition: drawerExitTransition
              }}
              initial={{ x: reducedMotion ? 0 : "-100%" }}
              animate={{ x: 0 }}
              role="dialog"
              ref={mobileDrawerRef}
              transition={drawerTransition}
            >
              <SidebarNavigation {...sidebarNavigationProps} idSuffix="mobile" />
            </m.aside>
          </>
        ) : null}
      </AnimatePresence>

      <div className="workspace">
        <header className="topbar">
          <div>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          <div className="topbar-actions">
            <button
              aria-expanded={isMobileNavigationOpen}
              aria-label="Open navigation menu"
              className="icon-button mobile-nav-toggle"
              ref={mobileToggleRef}
              onClick={() => setIsMobileNavigationOpen(true)}
              type="button"
            >
              <Menu aria-hidden="true" size={20} />
            </button>
            <div className="global-search-wrap" ref={globalSearchRef}>
              <form className="global-search" onSubmit={handleGlobalSearch}>
                <Search aria-hidden="true" className="global-search-icon" size={17} />
                <label className="sr-only" htmlFor="global-search-input">
                  Global search
                </label>
                <input
                  aria-activedescendant={
                    activeSuggestionIndex >= 0
                      ? `global-search-result-${searchSuggestions[activeSuggestionIndex]?.kind}-${searchSuggestions[activeSuggestionIndex]?.id}`
                      : undefined
                  }
                  aria-autocomplete="list"
                  aria-controls="global-search-results"
                  aria-expanded={isSearchOpen && globalQuery.trim().length >= 2}
                  id="global-search-input"
                  onChange={(event) => {
                    setGlobalQuery(event.target.value);
                    setIsSearchOpen(true);
                  }}
                  onFocus={() => {
                    if (globalQuery.trim().length >= 2) setIsSearchOpen(true);
                  }}
                  onKeyDown={handleGlobalSearchKeyDown}
                  placeholder="Search customers, assets, inspections..."
                  role="combobox"
                  value={globalQuery}
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
              {isSearchOpen && globalQuery.trim().length >= 2 ? (
                <div
                  aria-label="Search results"
                  className="global-search-results"
                  id="global-search-results"
                  role="listbox"
                >
                  {searchStatus === "loading" ? (
                    <p className="global-search-message" role="status">Searching HMS records...</p>
                  ) : null}
                  {searchStatus === "error" ? (
                    <p className="global-search-message" role="status">
                      Search is unavailable. Try again.
                    </p>
                  ) : null}
                  {searchStatus === "ready" && searchSuggestions.length === 0 ? (
                    <p className="global-search-message" role="status">
                      No matching HMS records.
                    </p>
                  ) : null}
                  {searchSuggestions.map((suggestion, index) => {
                    const Icon = suggestionIcon(suggestion.kind);
                    const isActive = index === activeSuggestionIndex;
                    return (
                      <button
                        aria-selected={isActive}
                        className={`global-search-result${isActive ? " is-active" : ""}`}
                        id={`global-search-result-${suggestion.kind}-${suggestion.id}`}
                        key={`${suggestion.kind}-${suggestion.id}`}
                        onClick={() => handleSearchSuggestionOpen(suggestion)}
                        role="option"
                        type="button"
                      >
                        <span aria-hidden="true" className="global-search-result-icon">
                          <Icon size={16} />
                        </span>
                        <span className="global-search-result-copy">
                          <strong>{suggestion.title}</strong>
                          <span>{suggestion.detail}</span>
                        </span>
                        <span className="global-search-result-kind">
                          {suggestionKindLabel(suggestion.kind)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            {canCreateAsset ? (
              <button
                className="primary-button topbar-primary"
                onClick={() => handleModuleChange("assets")}
                type="button"
              >
                <Plus aria-hidden="true" size={17} />
                New Asset
              </button>
            ) : null}
            <button
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              aria-pressed={theme === "dark"}
              className="icon-button theme-toggle"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              type="button"
            >
              {theme === "dark" ? <Sun aria-hidden="true" size={18} /> : <Moon aria-hidden="true" size={18} />}
            </button>
            <button
              aria-expanded={openMenu === "notifications"}
              aria-haspopup="dialog"
              className={`icon-button${notificationFeed.unreadTotal > 0 ? " has-count" : ""}`}
              aria-label={
                notificationFeed.unreadTotal > 0
                  ? `Notifications, ${notificationFeed.unreadTotal} unread`
                  : "Notifications"
              }
              onClick={() => {
                const isOpening = openMenu !== "notifications";
                setOpenMenu(isOpening ? "notifications" : null);
                if (isOpening) {
                  void notificationFeed.refresh({ queueIfBusy: true });
                }
              }}
              ref={notificationBellRef}
              type="button"
            >
              <Bell aria-hidden="true" size={18} />
              {notificationFeed.unreadTotal > 0 ? <span aria-hidden="true">{notificationFeed.unreadTotal}</span> : null}
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
              <div className="avatar">{initialsFor(accountName)}</div>
              <div>
                <strong>{accountName}</strong>
                <span>{roleLabel(session.roles[0] ?? "HMS_USER")}</span>
              </div>
              <ChevronDown aria-hidden="true" size={15} />
            </button>
          </div>
          {openMenu ? (
            <div
              className={`topbar-popover${
                openMenu === "notifications" ? " notification-popover" : ""
              }`}
              role="dialog"
              aria-label={popoverTitle(openMenu)}
            >
              <div className="topbar-popover-header">
                <strong>{popoverTitle(openMenu)}</strong>
                <button
                  aria-label={popoverCloseLabel(openMenu)}
                  className="icon-button light popover-close"
                  onClick={closeMenu}
                  type="button"
                >
                  <X aria-hidden="true" size={16} />
                </button>
              </div>
              {openMenu === "notifications" ? (
                <>
                  <NotificationList
                    error={notificationFeed.error}
                    items={notificationFeed.items.slice(0, BELL_ITEMS)}
                    onOpen={(notification) => void handleNotificationOpen(notification)}
                    onRetry={() => void notificationFeed.refresh()}
                    pendingId={notificationFeed.pendingId}
                    status={notificationFeed.status}
                  />
                  <div className="notification-actions">
                    <button
                      disabled={notificationFeed.markingAll || notificationFeed.unreadTotal === 0}
                      onClick={() => void handleMarkAllRead()}
                      type="button"
                    >
                      {notificationFeed.markingAll ? "Marking…" : "Mark all read"}
                    </button>
                    {notificationModule ? (
                      <button onClick={handleViewAllNotifications} type="button">
                        View all notifications
                      </button>
                    ) : null}
                  </div>
                </>
              ) : openMenu === "user" ? (
                <div className="account-popover-content">
                  <div className="account-identity">
                    <div className="avatar account-avatar">{initialsFor(accountName)}</div>
                    <div>
                      <strong>{accountName}</strong>
                      {accountEmail ? <span className="account-email">{accountEmail}</span> : null}
                    </div>
                  </div>
                  <div className="account-role" aria-label={`Roles: ${roleSummary(session.roles)}`}>
                    <ShieldCheck aria-hidden="true" size={15} />
                    <span>{roleSummary(session.roles)}</span>
                  </div>
                </div>
              ) : (
                <p>{popoverBody(openMenu, session)}</p>
              )}
              {openMenu === "user" && onLogout ? (
                <button
                  className="secondary-button popover-signout"
                  onClick={handleLogout}
                  type="button"
                >
                  <LogOut aria-hidden="true" size={15} />
                  Sign out
                </button>
              ) : null}
            </div>
          ) : null}
        </header>
        {children}
      </div>
    </div>
  );
}
