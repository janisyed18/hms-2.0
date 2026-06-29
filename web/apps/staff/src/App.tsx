import { useState } from "react";

import { ActivityFeed } from "./components/ActivityFeed";
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
import { useCustomerWorkspace } from "./hooks/useCustomerWorkspace";
import "./styles.css";

const moduleCopy: Record<AppModule, { title: string; description: string }> = {
  dashboard: {
    title: "Operations Dashboard",
    description: "Operational snapshot across HMS records and staff workflow queues"
  },
  customers: {
    title: "Customers",
    description: "Manage customers and view hose management overview"
  },
  assets: {
    title: "Assets",
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
    title: "Inspections",
    description: "Manage draft, submitted, and approved inspection workflows"
  },
  certificates: {
    title: "Certificates",
    description: "Issue and review versioned certificate records"
  },
  sync: {
    title: "Sync Queue",
    description: "Review local sync readiness and queued operational events"
  },
  audit: {
    title: "Audit Trail",
    description: "Review read-only staff activity and record lifecycle events"
  }
};

const operationalModules = new Set<AppModule>(["dashboard", "sync", "audit"]);

function isOperationalModule(module: AppModule): module is OperationalModule {
  return operationalModules.has(module);
}

export default function App() {
  const [activeModule, setActiveModule] = useState<AppModule>("dashboard");
  const workspace = useCustomerWorkspace();
  const activeCopy = moduleCopy[activeModule];

  return (
    <AppShell
      activeModule={activeModule}
      description={activeCopy.description}
      onModuleChange={setActiveModule}
      source={workspace.source}
      title={activeCopy.title}
    >
      {isOperationalModule(activeModule) ? (
        <main className="record-page">
          <div className="record-main">
            <OperationalWorkspace module={activeModule} source={workspace.source} />
          </div>
        </main>
      ) : activeModule === "customers" ? (
        <>
          <main className="customer-page">
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
            <CustomerDetail
              customer={workspace.selectedCustomer}
              activeTab={workspace.activeTab}
              onTabChange={workspace.setActiveTab}
            />
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
            {activeModule === "assets" ? <AssetsWorkspace /> : null}
            {activeModule === "products" ? <ProductsWorkspace /> : null}
            {activeModule === "reference" ? <ReferenceWorkspace /> : null}
            {activeModule === "inspections" ? <InspectionsWorkspace /> : null}
            {activeModule === "certificates" ? <CertificatesWorkspace /> : null}
          </div>
        </main>
      )}
    </AppShell>
  );
}
