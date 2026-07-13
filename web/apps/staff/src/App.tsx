import { useEffect, useMemo, useState } from "react";

import { ActivityFeed } from "./components/ActivityFeed";
import { AnalyticsWorkspace } from "./components/AnalyticsWorkspace";
import { AppShell, type AppModule } from "./components/AppShell";
import { AssetsWorkspace } from "./components/AssetsWorkspace";
import { CertificatesWorkspace } from "./components/CertificatesWorkspace";
import { CustomerDetail } from "./components/CustomerDetail";
import { CustomerForm } from "./components/CustomerForm";
import { CustomerTable } from "./components/CustomerTable";
import { InspectionsWorkspace } from "./components/InspectionsWorkspace";
import {
  OperationalWorkspace,
  type OperationalModule
} from "./components/OperationalWorkspace";
import { ProductsWorkspace } from "./components/ProductsWorkspace";
import { ReferenceWorkspace } from "./components/ReferenceWorkspace";
import { RetestScheduleWorkspace } from "./components/RetestScheduleWorkspace";
import { WorkspaceState } from "./components/WorkspaceState";
import {
  SystemWorkspace,
  type SystemModule
} from "./components/SystemWorkspace";
import { AuthFlow } from "./auth/AuthFlow";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import type { BrowserAuthClient } from "./auth/authClient";
import type { StaffPermission, StaffRole, StaffSession } from "./domain/types";
import { useCustomerWorkspace } from "./hooks/useCustomerWorkspace";
import { PageMotion } from "./motion/MotionPrimitives";

const moduleCopy: Record<AppModule, { title: string; description: string }> = {
  dashboard: {
    title: "Dashboard",
    description: "Operational snapshot across HMS records and staff workflow queues"
  },
  analytics: {
    title: "Analytics",
    description: "Fleet reporting and operational performance trends"
  },
  customers: {
    title: "Customer Management",
    description: "Manage customers and view hose management overview"
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

const operationalModules = new Set<AppModule>(["dashboard", "sync", "audit"]);

const allPermissions: StaffPermission[] = [
  "customer:read",
  "customer:write",
  "asset:read",
  "asset:write",
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
    "reference:admin",
    "user:admin",
    "device:admin",
    "audit:read"
  ],
  INSPECTOR: ["customer:read", "asset:read", "inspection:write"],
  ASSEMBLY: ["customer:read", "asset:read", "asset:write"],
  REVIEWER: ["customer:read", "asset:read", "certificate:approve"],
  CUSTOMER_USER: ["customer:read", "asset:read"]
};

const allModules: AppModule[] = [
  "dashboard",
  "analytics",
  "customers",
  "assets",
  "products",
  "reference",
  "inspections",
  "certificates",
  "retest",
  "sync",
  "audit",
  "users",
  "devices"
];

const roleModules: Record<StaffRole, AppModule[]> = {
  SUPER_ADMIN: allModules,
  HMS_ADMIN: allModules.filter((module) => module !== "sync"),
  INSPECTOR: ["dashboard", "customers", "assets", "inspections", "retest", "sync"],
  ASSEMBLY: ["dashboard", "customers", "assets", "retest"],
  REVIEWER: ["dashboard", "customers", "assets", "inspections", "certificates", "retest"],
  CUSTOMER_USER: ["dashboard", "customers", "assets", "inspections", "certificates", "retest"]
};

interface AppProps {
  // Explicit test/story seam: providing a session bypasses auth gating.
  initialSession?: StaffSession;
  // Test seam for injecting a fake browser-auth client.
  authClient?: BrowserAuthClient;
}

interface HmsAppProps {
  session: StaffSession;
  onLogout?: () => void;
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
      <AuthGate />
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

export function HmsApp({ session: providedSession, onLogout }: HmsAppProps) {
  const [activeModule, setActiveModule] = useState<AppModule>("dashboard");
  const [session, setSession] = useState<StaffSession>(
    normaliseSession(providedSession)
  );
  const workspace = useCustomerWorkspace();
  const visibleModules = useMemo(() => modulesForSession(session), [session]);
  const renderedActiveModule = visibleModules.includes(activeModule)
    ? activeModule
    : visibleModules[0] ?? "dashboard";
  const activeCopy = moduleCopy[renderedActiveModule];
  const canCreateAsset = hasPermission(session, "asset:write");

  useEffect(() => {
    setSession(normaliseSession(providedSession));
  }, [providedSession]);

  useEffect(() => {
    if (!visibleModules.includes(activeModule)) {
      setActiveModule(visibleModules[0] ?? "dashboard");
    }
  }, [activeModule, visibleModules]);

  function handleModuleChange(module: AppModule) {
    if (visibleModules.includes(module)) {
      setActiveModule(module);
    }
  }

  return (
    <AppShell
      activeModule={renderedActiveModule}
      canCreateAsset={canCreateAsset}
      description={activeCopy.description}
      onLogout={onLogout}
      onModuleChange={handleModuleChange}
      session={session}
      source={workspace.source}
      title={activeCopy.title}
      visibleModules={visibleModules}
    >
      <PageMotion key={renderedActiveModule} motionKey={renderedActiveModule}>
        {isOperationalModule(renderedActiveModule) ? (
          <main className="record-page">
            <div className="record-main">
              <OperationalWorkspace
                module={renderedActiveModule}
                source={workspace.source}
              />
            </div>
          </main>
        ) : renderedActiveModule === "customers" ? (
          <>
            <main className={`customer-page${workspace.selectedCustomer ? "" : " detail-closed"}`}>
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
                    <CustomerTable
                      canWrite={hasPermission(session, "customer:write")}
                      customers={workspace.visibleCustomers}
                      totalCount={workspace.totalCount}
                      selectedId={workspace.selectedCustomer?.id ?? null}
                      query={workspace.query}
                      riskFilter={workspace.riskFilter}
                      statusFilter={workspace.statusFilter}
                      onQueryChange={workspace.setQuery}
                      onRiskFilterChange={workspace.setRiskFilter}
                      onStatusFilterChange={workspace.setStatusFilter}
                      onSelectCustomer={workspace.setSelectedId}
                      onAddCustomer={() => workspace.setFormOpen(true)}
                    />
                    <ActivityFeed items={workspace.selectedCustomer?.metrics.activity ?? []} />
                  </>
                )}
              </div>
              {!workspace.isLoading && !workspace.error && workspace.selectedCustomer ? (
                <CustomerDetail
                  customer={workspace.selectedCustomer}
                  activeTab={workspace.activeTab}
                  onClose={workspace.closeDetail}
                  onTabChange={workspace.setActiveTab}
                />
              ) : null}
            </main>
            <CustomerForm
              open={workspace.isFormOpen}
              onClose={() => workspace.setFormOpen(false)}
              onSubmit={workspace.createCustomer}
            />
          </>
        ) : (
          <main className="record-page">
            <div className="record-main">
              {renderedActiveModule === "assets" ? (
                <AssetsWorkspace canWrite={hasPermission(session, "asset:write")} />
              ) : null}
              {renderedActiveModule === "analytics" ? (
                <AnalyticsWorkspace source={workspace.source} />
              ) : null}
              {renderedActiveModule === "products" ? <ProductsWorkspace /> : null}
              {renderedActiveModule === "reference" ? <ReferenceWorkspace /> : null}
              {renderedActiveModule === "inspections" ? (
                <InspectionsWorkspace
                  canApprove={hasPermission(session, "certificate:approve")}
                  canWrite={hasPermission(session, "inspection:write")}
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
                  source={workspace.source}
                />
              ) : null}
            </div>
          </main>
        )}
      </PageMotion>
    </AppShell>
  );
}

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
