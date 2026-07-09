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
import {
  SystemWorkspace,
  type SystemModule
} from "./components/SystemWorkspace";
import { loadAuthSessionWithFallback } from "./api/hmsClient";
import { mockStaffSession } from "./data/mockAdmin";
import type { StaffPermission, StaffRole, StaffSession } from "./domain/types";
import { useCustomerWorkspace } from "./hooks/useCustomerWorkspace";
import "./styles.css";

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

const modulePermissions: Record<AppModule, StaffPermission[]> = {
  dashboard: [],
  analytics: ["audit:read"],
  customers: ["customer:read"],
  assets: ["asset:read"],
  products: ["reference:admin"],
  reference: ["reference:admin"],
  inspections: ["inspection:write", "certificate:approve"],
  certificates: ["certificate:approve"],
  retest: ["asset:read"],
  sync: ["inspection:write"],
  audit: ["audit:read"],
  users: ["user:admin"],
  devices: ["device:admin"]
};

interface AppProps {
  initialSession?: StaffSession;
}

function isOperationalModule(module: AppModule): module is OperationalModule {
  return operationalModules.has(module);
}

function isSystemModule(module: AppModule): module is SystemModule {
  return module === "users" || module === "devices";
}

export default function App(props: AppProps = {}) {
  return <HmsApp {...props} />;
}

export function HmsApp({ initialSession }: AppProps = {}) {
  const [activeModule, setActiveModule] = useState<AppModule>("dashboard");
  const [session, setSession] = useState<StaffSession>(
    normaliseSession(initialSession ?? mockStaffSession)
  );
  const workspace = useCustomerWorkspace();
  const visibleModules = useMemo(() => modulesForSession(session), [session]);
  const renderedActiveModule = visibleModules.includes(activeModule)
    ? activeModule
    : visibleModules[0] ?? "dashboard";
  const activeCopy = moduleCopy[renderedActiveModule];
  const canCreateAsset = hasPermission(session, "asset:write");

  useEffect(() => {
    if (initialSession) {
      return;
    }
    let cancelled = false;
    void loadAuthSessionWithFallback().then((loadedSession) => {
      if (!cancelled) {
        setSession(normaliseSession(loadedSession));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialSession]);

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
      onModuleChange={handleModuleChange}
      session={session}
      source={workspace.source}
      title={activeCopy.title}
      visibleModules={visibleModules}
    >
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
              <CustomerTable
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
            </div>
            {workspace.selectedCustomer ? (
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
            {renderedActiveModule === "assets" ? <AssetsWorkspace /> : null}
            {renderedActiveModule === "analytics" ? (
              <AnalyticsWorkspace source={workspace.source} />
            ) : null}
            {renderedActiveModule === "products" ? <ProductsWorkspace /> : null}
            {renderedActiveModule === "reference" ? <ReferenceWorkspace /> : null}
            {renderedActiveModule === "inspections" ? <InspectionsWorkspace /> : null}
            {renderedActiveModule === "certificates" ? <CertificatesWorkspace /> : null}
            {renderedActiveModule === "retest" ? <RetestScheduleWorkspace /> : null}
            {isSystemModule(renderedActiveModule) ? (
              <SystemWorkspace module={renderedActiveModule} source={workspace.source} />
            ) : null}
          </div>
        </main>
      )}
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

function modulesForSession(session: StaffSession): AppModule[] {
  return (Object.keys(modulePermissions) as AppModule[]).filter((module) => {
    const required = modulePermissions[module];
    return (
      required.length === 0 ||
      required.some((permission) => hasPermission(session, permission))
    );
  });
}
