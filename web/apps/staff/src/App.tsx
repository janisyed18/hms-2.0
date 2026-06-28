import { ActivityFeed } from "./components/ActivityFeed";
import { AppShell } from "./components/AppShell";
import { CustomerDetail } from "./components/CustomerDetail";
import { CustomerForm } from "./components/CustomerForm";
import { CustomerTable } from "./components/CustomerTable";
import { useCustomerWorkspace } from "./hooks/useCustomerWorkspace";
import "./styles.css";

export default function App() {
  const workspace = useCustomerWorkspace();

  return (
    <AppShell source={workspace.source}>
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
    </AppShell>
  );
}
