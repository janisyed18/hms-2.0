import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  CalendarClock,
  ClipboardCheck,
  Database,
  FileCheck2,
  LayoutDashboard,
  MapPinned
} from "lucide-react";

import { notificationTarget } from "./notifications/target";
import { NotificationCenterProvider } from "./notifications/NotificationCenterProvider";
import { NotificationsPage } from "./notifications/NotificationsPage";
import { AppShell, type AppModule, type GlobalSearchSuggestion, type NavItem } from "./components/AppShell";
import { AssetsWorkspace } from "./components/AssetsWorkspace";
import { CustomerDetail } from "./components/CustomerDetail";
import { CustomerForm } from "./components/CustomerForm";
import { ActionNotice } from "./components/interaction/ActionNotice";
import { ToastProvider } from "./components/interaction/Toast";
import { CustomerTable } from "./components/CustomerTable";
import type { OperationalModule } from "./components/OperationalWorkspace";
import { WorkspaceState } from "./components/WorkspaceState";
import { MyWorkWorkspace } from "./components/MyWorkWorkspace";
import type { SystemModule } from "./components/SystemWorkspace";
import { createHmsClient } from "./api/hmsClient";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import type { BrowserAuthClient } from "./auth/authClient";
import type { AssetWorkflowAction, MyWorkItem, NotificationRecord, StaffPermission, StaffRole, StaffSession } from "./domain/types";
import { useCustomerWorkspace } from "./hooks/useCustomerWorkspace";
import { PageMotion } from "./motion/MotionPrimitives";
import { useHmsRoute } from "./routing/useHmsRoute";
import { emptyRoute, type UsersRouteQuery } from "./routing/routeTypes";
import { greetingName } from "./utils/identity";

const AnalyticsWorkspace = lazy(() =>
  import("./components/AnalyticsWorkspace").then(({ AnalyticsWorkspace }) => ({
    default: AnalyticsWorkspace
  }))
);
const AuditWorkspace = lazy(() =>
  import("./components/AuditWorkspace").then(({ AuditWorkspace }) => ({
    default: AuditWorkspace
  }))
);
const AuthFlow = lazy(() =>
  import("./auth/AuthFlow").then(({ AuthFlow }) => ({ default: AuthFlow }))
);
const CertificatesWorkspace = lazy(() =>
  import("./components/CertificatesWorkspace").then(({ CertificatesWorkspace }) => ({
    default: CertificatesWorkspace
  }))
);
const InspectionsWorkspace = lazy(() =>
  import("./components/InspectionsWorkspace").then(({ InspectionsWorkspace }) => ({
    default: InspectionsWorkspace
  }))
);
const SchedulingWorkspace = lazy(() =>
  import("./components/SchedulingWorkspace").then(({ SchedulingWorkspace }) => ({
    default: SchedulingWorkspace
  }))
);
const OperationalWorkspace = lazy(() =>
  import("./components/OperationalWorkspace").then(({ OperationalWorkspace }) => ({
    default: OperationalWorkspace
  }))
);
const ProductsWorkspace = lazy(() =>
  import("./components/ProductsWorkspace").then(({ ProductsWorkspace }) => ({
    default: ProductsWorkspace
  }))
);
const ReferenceWorkspace = lazy(() =>
  import("./components/ReferenceWorkspace").then(({ ReferenceWorkspace }) => ({
    default: ReferenceWorkspace
  }))
);
const RetestScheduleWorkspace = lazy(() =>
  import("./components/RetestScheduleWorkspace").then(({ RetestScheduleWorkspace }) => ({
    default: RetestScheduleWorkspace
  }))
);
const SystemWorkspace = lazy(() =>
  import("./components/SystemWorkspace").then(({ SystemWorkspace }) => ({
    default: SystemWorkspace
  }))
);
const CustomerPortalWorkspace = lazy(() =>
  import("./components/CustomerPortalWorkspace").then(({ CustomerPortalWorkspace }) => ({
    default: CustomerPortalWorkspace
  }))
);

const moduleCopy: Record<AppModule, { title: string; description: string }> = {
  dashboard: {
    title: "Dashboard",
    description: "Operational snapshot across HMS records and staff workflow queues"
  },
  "my-work": {
    title: "My Work",
    description: "Your next permitted actions across current HMS workflows"
  },
  analytics: {
    title: "Analytics",
    description: "Fleet reporting and operational performance trends"
  },
  customers: {
    title: "Customer Management",
    description: "Manage customers and view hose management overview"
  },
  locations: {
    title: "Locations",
    description: "Your approved sites and site requirements"
  },
  bookings: {
    title: "Bookings",
    description: "Request, track, reschedule, or cancel inspection appointments"
  },
  assets: {
    title: "Asset Register",
    description: "Track hose assemblies, lifecycle status, and retest scheduling"
  },
  products: {
    title: "Products",
    description: "Maintain hose product catalog records and standards"
  },
  reference: {
    title: "Reference Data",
    description: "Manage controlled standards and lookup data"
  },
  scheduling: {
    title: "Scheduling",
    description: "Dispatch calendar for inspection visits, inspectors and booking requests"
  },
  inspections: {
    title: "Inspection Management",
    description: "Manage draft, submitted, and approved inspection workflows"
  },
  certificates: {
    title: "Certificate Management",
    description: "Issue and review versioned certificate records"
  },
  retest: {
    title: "Retest Schedule",
    description: "Plan upcoming hose assembly retest work"
  },
  notifications: {
    title: "Notifications",
    description: "Review operational updates and required actions"
  },
  sync: {
    title: "Sync Queue",
    description: "Review local sync readiness and queued operational events"
  },
  audit: {
    title: "Audit Trail",
    description: "Review read-only staff activity and record lifecycle events"
  },
  users: {
    title: "Users & Roles",
    description: "Manage staff access and role assignments"
  },
  devices: {
    title: "Devices",
    description: "Manage registered mobile and field devices"
  }
};

const operationalModules = new Set<AppModule>(["dashboard", "sync"]);

const allPermissions: StaffPermission[] = [
  "customer:read",
  "customer:write",
  "asset:read",
  "asset:write",
  "inspection:book",
  "inspection:write",
  "certificate:approve",
  "reference:admin",
  "user:admin",
  "device:admin",
  "audit:read"
];

const rolePermissions: Record<StaffRole, StaffPermission[]> = {
  SUPER_ADMIN: allPermissions,
  HMS_ADMIN: [
    "customer:read",
    "customer:write",
    "asset:read",
    "asset:write",
    "inspection:book",
    "reference:admin",
    "user:admin",
    "device:admin",
    "audit:read"
  ],
  INSPECTOR: ["customer:read", "asset:read", "inspection:write"],
  ASSEMBLY: ["customer:read", "asset:read", "asset:write"],
  REVIEWER: ["customer:read", "asset:read", "certificate:approve"],
  CUSTOMER_USER: ["customer:read", "asset:read", "inspection:book"]
};

const allModules: AppModule[] = [
  "dashboard",
  "my-work",
  "analytics",
  "customers",
  "assets",
  "products",
  "reference",
  "scheduling",
  "inspections",
  "certificates",
  "retest",
  "sync",
  "audit",
  "users",
  "devices",
  "notifications"
];

const roleModules: Record<StaffRole, AppModule[]> = {
  SUPER_ADMIN: allModules,
  HMS_ADMIN: allModules.filter((module) => module !== "sync"),
  INSPECTOR: ["dashboard", "my-work", "customers", "assets", "scheduling", "inspections", "retest", "sync", "notifications"],
  ASSEMBLY: ["dashboard", "my-work", "customers", "assets", "retest", "notifications"],
  REVIEWER: ["dashboard", "my-work", "customers", "assets", "inspections", "certificates", "retest", "notifications"],
  CUSTOMER_USER: ["dashboard", "my-work", "customers", "assets", "inspections", "certificates", "retest", "notifications"]
};

const customerPortalModules: AppModule[] = [
  "dashboard",
  "assets",
  "locations",
  "bookings",
  "inspections",
  "certificates",
  "retest",
  "notifications"
];

const customerPortalNavGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Workspace",
    items: [
      { label: "Dashboard", icon: LayoutDashboard, module: "dashboard" },
      { label: "Assets", icon: Database, module: "assets" },
      { label: "Locations", icon: MapPinned, module: "locations" },
      { label: "Bookings", icon: CalendarClock, module: "bookings" },
      { label: "Inspections", icon: ClipboardCheck, module: "inspections" },
      { label: "Certificates", icon: FileCheck2, module: "certificates" },
      { label: "Retests", icon: CalendarClock, module: "retest" },
      { label: "Notifications", icon: Bell, module: "notifications" }
    ]
  }
];

interface AppProps {
  // Explicit test/story seam: providing a session bypasses auth gating.
  initialSession?: StaffSession;
  // Test seam for injecting a fake browser-auth client.
  authClient?: BrowserAuthClient;
}

interface HmsAppProps {
  session: StaffSession;
  onLogout?: () => void;
  portalMode?: boolean;
}

function isOperationalModule(module: AppModule): module is OperationalModule {
  return operationalModules.has(module);
}

function isSystemModule(module: AppModule): module is SystemModule {
  return module === "users" || module === "devices";
}

export default function App({ initialSession, authClient }: AppProps = {}) {
  if (initialSession) {
    return <HmsApp session={initialSession} />;
  }
  return (
    <AuthProvider client={authClient}>
      <Suspense
        fallback={
          <WorkspaceState title="Loading sign-in" tone="loading">
            Preparing secure staff authentication.
          </WorkspaceState>
        }
      >
        <AuthGate />
      </Suspense>
    </AuthProvider>
  );
}

function AuthGate() {
  const { state, logout } = useAuth();
  return (
    <AuthFlow>
      {state.status === "authenticated" ? (
        <HmsApp session={state.session} onLogout={() => void logout()} />
      ) : null}
    </AuthFlow>
  );
}

export function CustomerPortalApp({ authClient }: Pick<AppProps, "authClient">) {
  return (
    <AuthProvider client={authClient}>
      <Suspense fallback={<WorkspaceState title="Loading portal" tone="loading">Preparing your customer workspace.</WorkspaceState>}>
        <CustomerPortalGate />
      </Suspense>
    </AuthProvider>
  );
}

function CustomerPortalGate() {
  const { state, logout } = useAuth();
  return (
    <AuthFlow audience="customer">
      {state.status === "authenticated" ? (
        state.session.roles.includes("CUSTOMER_USER") ? (
          <HmsApp portalMode session={state.session} onLogout={() => void logout()} />
        ) : (
          <WorkspaceState title="Customer portal access required" tone="error">
            This account is not assigned to a customer portal workspace.
          </WorkspaceState>
        )
      ) : null}
    </AuthFlow>
  );
}

export function HmsApp({ session: providedSession, onLogout, portalMode = false }: HmsAppProps) {
  const [session, setSession] = useState<StaffSession>(
    normaliseSession(providedSession)
  );
  const visibleModules = useMemo(
    () => (portalMode ? customerPortalModules : modulesForSession(session)),
    [portalMode, session]
  );
  // The address bar is the record of where we are: which workspace, and which customer, asset,
  // inspection or user query is open. A link naming a view this person may not open never renders it.
  const { route, navigate } = useHmsRoute(portalMode ? "portal" : "staff", visibleModules, visibleModules[0] ?? "dashboard");
  const renderedActiveModule = route.view as AppModule;
  const [customerUnavailable, setCustomerUnavailable] = useState(false);
  const workspace = useCustomerWorkspace({
    active: renderedActiveModule === "customers",
    onSelectedChange: (id) => navigate((current) => ({ ...emptyRoute("customers"), customer: id, users: current.users }))
  });
  const { setSelectedId: setWorkspaceSelectedId, addCustomer: addWorkspaceCustomer, isLoading: customersLoading, customers: workspaceCustomers } = workspace;
  const activeCopy = portalMode
    ? customerPortalCopy[renderedActiveModule] ?? moduleCopy[renderedActiveModule]
    : moduleCopy[renderedActiveModule];
  const canCreateAsset = hasPermission(session, "asset:write");

  useEffect(() => {
    setSession(normaliseSession(providedSession));
  }, [providedSession]);

  // URL to the customer detail: the link, or Back/Forward, opens or closes it. The register loads one page,
  // so a customer that is not in it is asked for by id; only if that read fails (missing, or not theirs) is it
  // unavailable, and the link then stops naming it. What comes back is used only if the URL still asks for it.
  const routeCustomerId = !portalMode && route.view === "customers" ? route.customer : null;
  const wantedCustomer = useRef<string | null>(null);
  useEffect(() => {
    wantedCustomer.current = routeCustomerId;
    if (customersLoading) return;
    if (!routeCustomerId || workspaceCustomers.some((customer) => customer.id === routeCustomerId)) {
      setWorkspaceSelectedId(routeCustomerId);
      return;
    }
    setWorkspaceSelectedId(null);
    createHmsClient().getCustomer(routeCustomerId)
      .then((found) => {
        if (wantedCustomer.current !== routeCustomerId) return;
        addWorkspaceCustomer(found);
      })
      .catch(() => {
        if (wantedCustomer.current !== routeCustomerId) return;
        setCustomerUnavailable(true);
        navigate({ customer: null }, { replace: true });
      });
  }, [routeCustomerId, customersLoading, workspaceCustomers, setWorkspaceSelectedId, addWorkspaceCustomer, navigate]);

  const onPortalCustomerChange = useCallback(
    (customerId: string, options?: { replace?: boolean }) => navigate({ customer: customerId, asset: null }, options),
    [navigate]
  );
  const onAssetRouteChange = useCallback(
    (assetId: string | null, options?: { replace?: boolean }) => navigate({ asset: assetId }, options),
    [navigate]
  );
  const onInspectionRouteChange = useCallback(
    (inspectionId: string | null, options?: { replace?: boolean }) => navigate({ inspection: inspectionId }, options),
    [navigate]
  );
  const onUsersRouteChange = useCallback(
    (patch: Partial<UsersRouteQuery>, options?: { replace?: boolean }) =>
      navigate((current) => ({ ...current, users: { ...current.users, ...patch } }), options),
    [navigate]
  );
  const usersRoute = useMemo(() => ({ query: route.users, onChange: onUsersRouteChange }), [route.users, onUsersRouteChange]);

  function handleModuleChange(module: AppModule, inspectionId?: string) {
    if (visibleModules.includes(module)) {
      // A new workspace starts clean; the portal keeps its organisation.
      navigate((current) => ({ ...emptyRoute(module), inspection: module === "inspections" ? inspectionId ?? null : null, customer: portalMode ? current.customer : null }));
    }
  }

  function handleAssetOpen(assetId: string) {
    if (!visibleModules.includes("assets")) {
      return;
    }
    navigate((current) => ({ ...emptyRoute("assets"), asset: assetId, customer: portalMode ? current.customer : null }));
  }

  // The workflow's semantic next action, mapped onto this app's routes. An action whose target this
  // account has no workspace for is not offered at all.
  function workflowTargetView(action: AssetWorkflowAction): AppModule {
    if (action.targetType === "INSPECTION") return "inspections";
    if (action.targetType === "SCHEDULING") return "scheduling";
    if (action.targetType === "CERTIFICATES") return "certificates";
    return "assets";
  }

  function handleWorkOpen(item: MyWorkItem) {
    const action = item.nextAction;
    const view = workflowTargetView(action as AssetWorkflowAction);
    if (!visibleModules.includes(view)) return;
    navigate((current) => ({
      ...emptyRoute(view),
      asset: view === "assets" ? item.assetId : null,
      inspection: view === "inspections" ? action.targetId ?? action.inspectionId ?? item.inspectionId : null,
      customer: portalMode ? current.customer : null
    }));
  }
  const workflowNavigation = {
    canOpen: (action: AssetWorkflowAction) =>
      visibleModules.includes(workflowTargetView(action)) && (action.targetType !== "INSPECTION" || Boolean(action.targetId)),
    open: (action: AssetWorkflowAction) => {
      const view = workflowTargetView(action);
      handleModuleChange(view, action.targetType === "INSPECTION" ? action.targetId ?? undefined : undefined);
    }
  };

  // A notification leads to the record it is about, by the ids it carries; anything this account has
  // no workspace for lands on the notifications page instead.
  function handleNotificationOpen(notification: NotificationRecord) {
    const target = notificationTarget(notification, portalMode ? "portal" : "staff");
    if (!target || !visibleModules.includes(target.module)) {
      handleModuleChange("notifications");
      return;
    }
    navigate((current) => ({
      ...emptyRoute(target.module),
      asset: target.assetId ?? null,
      inspection: target.inspectionId ?? null,
      customer: portalMode ? current.customer : (target.customerId ?? null)
    }));
  }

  function handleSearchRecordOpen(suggestion: GlobalSearchSuggestion) {
    if (!visibleModules.includes(suggestion.module)) {
      return;
    }
    if (suggestion.kind === "customer") {
      navigate({ ...emptyRoute("customers"), customer: suggestion.id });
      return;
    }
    if (suggestion.kind === "asset") {
      handleAssetOpen(suggestion.id);
      return;
    }
    if (suggestion.kind === "inspection") {
      handleModuleChange("inspections", suggestion.id);
      return;
    }
    navigate(emptyRoute("products"));
  }

  // The notification provider is keyed by scope: a different organisation is a fresh feed, so the
  // old one's items, count and timers are gone at once, not after the new one has loaded.
  return (
    <ToastProvider>
      <NotificationCenterProvider
        customerId={portalMode ? route.customer : undefined}
        key={portalMode ? (route.customer ?? "no-customer") : "staff"}
      >
      <AppShell
        activeModule={renderedActiveModule}
        canCreateAsset={canCreateAsset}
        description={activeCopy.description}
        hideGlobalSearch={portalMode}
        navGroups={portalMode ? customerPortalNavGroups : undefined}
        notificationModule="notifications"
        onLogout={onLogout}
        onNotificationOpen={handleNotificationOpen}
        onModuleChange={handleModuleChange}
        onSearchRecordOpen={handleSearchRecordOpen}
        session={session}
        title={activeCopy.title}
        visibleModules={visibleModules}
      >
        <PageMotion key={renderedActiveModule} motionKey={renderedActiveModule}>
          <Suspense
            fallback={
              <WorkspaceState title="Loading workspace" tone="loading">
                Preparing the selected HMS workspace.
              </WorkspaceState>
            }
          >
            {renderedActiveModule === "notifications" ? (
              <main className="record-page">
                <div className="record-main">
                  <NotificationsPage onOpen={handleNotificationOpen} />
                </div>
              </main>
            ) : renderedActiveModule === "my-work" ? (
              <main className="record-page"><div className="record-main"><MyWorkWorkspace onOpen={handleWorkOpen} /></div></main>
            ) : renderedActiveModule === "audit" ? (
              <main className="record-page"><div className="record-main"><AuditWorkspace /></div></main>
            ) : portalMode ? (
              <main className="record-page customer-portal-page">
                <div className="record-main">
                  <CustomerPortalWorkspace
                    activeModule={renderedActiveModule}
                    assetId={route.asset}
                    customerId={route.customer}
                    key={route.customer ?? "customer"}
                    onAssetChange={onAssetRouteChange}
                    onCustomerChange={onPortalCustomerChange}
                    onModuleChange={handleModuleChange}
                    session={session}
                  />
                </div>
              </main>
            ) : isOperationalModule(renderedActiveModule) ? (
              <main className="record-page">
                <div className="record-main">
                  <OperationalWorkspace
                    canEscalate={hasPermission(session, "asset:write")}
                    module={renderedActiveModule}
                    onAssetOpen={handleAssetOpen}
                    onModuleChange={handleModuleChange}
                    userName={greetingName(session)}
                  />
                </div>
              </main>
            ) : renderedActiveModule === "customers" ? (
              <>
                <main className="customer-page">
                  <div className="customer-main">
                    {workspace.isLoading ? (
                      <WorkspaceState title="Loading customers" tone="loading">
                        Retrieving the customer register.
                      </WorkspaceState>
                    ) : workspace.error ? (
                      <WorkspaceState title="Customer data unavailable" tone="error">
                        {workspace.error}
                      </WorkspaceState>
                    ) : (
                      <>
                        {customerUnavailable ? (
                          <ActionNotice kind="error" onDismiss={() => setCustomerUnavailable(false)} title="Customer unavailable">
                            That customer could not be found, or you do not have access to it.
                          </ActionNotice>
                        ) : null}
                        {workspace.notice ? (
                          <ActionNotice kind={workspace.notice.kind} onDismiss={workspace.dismissNotice} title={workspace.notice.title}>
                            {workspace.notice.message}
                          </ActionNotice>
                        ) : null}
                        <CustomerTable
                          canWrite={hasPermission(session, "customer:write")}
                          allCustomers={workspace.customers}
                          customers={workspace.visibleCustomers}
                          totalCount={workspace.totalCount}
                          selectedId={workspace.selectedCustomer?.id ?? null}
                          query={workspace.query}
                          riskFilter={workspace.riskFilter}
                          statusFilter={workspace.statusFilter}
                          onQueryChange={workspace.setQuery}
                          onRiskFilterChange={workspace.setRiskFilter}
                          onStatusFilterChange={workspace.setStatusFilter}
                          onSelectCustomer={workspace.selectCustomer}
                          onAddCustomer={workspace.openCreateCustomer}
                        />
                      </>
                    )}
                  </div>
                </main>
                <CustomerDetail
                  customer={workspace.selectedCustomer}
                  activeTab={workspace.activeTab}
                  canWrite={hasPermission(session, "customer:write")}
                  onAssetOpen={handleAssetOpen}
                  onClose={workspace.closeDetail}
                  onEdit={() => {
                    if (!workspace.selectedCustomer) return;
                    const customer = workspace.selectedCustomer;
                    workspace.closeDetail();
                    workspace.openEditCustomer(customer);
                  }}
                  onTabChange={workspace.setActiveTab}
                />
                <CustomerForm
                  open={workspace.isFormOpen}
                  customer={workspace.editingCustomer}
                  onClose={workspace.closeCustomerForm}
                  onSubmit={workspace.saveCustomer}
                />
              </>
            ) : (
              <main className="record-page">
                <div className="record-main">
                  {renderedActiveModule === "assets" ? (
                    <AssetsWorkspace
                      canWrite={hasPermission(session, "asset:write")}
                      onAssetRouteChange={onAssetRouteChange}
                      routeAssetId={route.asset}
                      workflowNavigation={workflowNavigation}
                    />
                  ) : null}
                  {renderedActiveModule === "analytics" ? (
                    <AnalyticsWorkspace onModuleChange={handleModuleChange} />
                  ) : null}
                  {renderedActiveModule === "products" ? (
                    <ProductsWorkspace canManage={hasPermission(session, "reference:admin")} />
                  ) : null}
                  {renderedActiveModule === "reference" ? (
                    <ReferenceWorkspace canManage={hasPermission(session, "reference:admin")} />
                  ) : null}
                  {renderedActiveModule === "scheduling" ? (
                    <SchedulingWorkspace
                      canBook={hasPermission(session, "inspection:book")}
                      canApproveBookings={session.roles.some((role) =>
                        role === "SUPER_ADMIN" || role === "HMS_ADMIN"
                      )}
                    />
                  ) : null}
                  {renderedActiveModule === "inspections" ? (
                    <InspectionsWorkspace
                      canBook={hasPermission(session, "inspection:book")}
                      canApprove={hasPermission(session, "certificate:approve")}
                      canApproveBookings={session.roles.some((role) =>
                        role === "SUPER_ADMIN" || role === "HMS_ADMIN"
                      )}
                      canWrite={hasPermission(session, "inspection:write")}
                      onInspectionRouteChange={onInspectionRouteChange}
                      routeInspectionId={route.inspection}
                    />
                  ) : null}
                  {renderedActiveModule === "certificates" ? (
                    <CertificatesWorkspace
                      canManage={hasPermission(session, "certificate:approve")}
                    />
                  ) : null}
                  {renderedActiveModule === "retest" ? (
                    <RetestScheduleWorkspace
                      canWrite={hasPermission(session, "asset:write")}
                    />
                  ) : null}
                  {isSystemModule(renderedActiveModule) ? (
                    <SystemWorkspace
                      actorRoles={session.roles}
                      customerOptions={workspace.customers.map((customer) => ({
                        id: customer.id,
                        name: customer.name
                      }))}
                      module={renderedActiveModule}
                      usersRoute={usersRoute}
                    />
                  ) : null}
                </div>
              </main>
            )}
          </Suspense>
        </PageMotion>
      </AppShell>
      </NotificationCenterProvider>
    </ToastProvider>
  );
}

const customerPortalCopy: Partial<Record<AppModule, { title: string; description: string }>> = {
  dashboard: {
    title: "Customer Portal",
    description: "Your fleet status, upcoming work, and service activity"
  },
  locations: {
    title: "Locations",
    description: "Approved sites, contacts, and work requirements"
  },
  bookings: {
    title: "Bookings",
    description: "Request and manage inspection appointments"
  },
  assets: {
    title: "Asset Register",
    description: "Hose assemblies assigned to your organisation"
  },
  inspections: {
    title: "Inspections",
    description: "Request site inspections and follow their progress"
  },
  certificates: {
    title: "Certificates",
    description: "View certificates issued for your fleet"
  },
  retest: {
    title: "Retest Schedule",
    description: "Plan work around upcoming retest due dates"
  },
  notifications: {
    title: "Notifications",
    description: "Updates for your assets, bookings, and certificates"
  }
};

function normaliseSession(session: StaffSession): StaffSession {
  const permissions = new Set<StaffPermission>(session.permissions);
  session.roles.forEach((role) => {
    rolePermissions[role].forEach((permission) => permissions.add(permission));
  });
  return {
    ...session,
    permissions: Array.from(permissions)
  };
}

function hasPermission(session: StaffSession, permission: StaffPermission): boolean {
  return (
    session.roles.includes("SUPER_ADMIN") || session.permissions.includes(permission)
  );
}

export function modulesForSession(session: StaffSession): AppModule[] {
  const visible = new Set<AppModule>();
  session.roles.forEach((role) => {
    roleModules[role].forEach((module) => visible.add(module));
  });
  return allModules.filter((module) => visible.has(module));
}
