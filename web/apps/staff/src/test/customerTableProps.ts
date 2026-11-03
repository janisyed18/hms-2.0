import type { ComponentProps } from "react";

import type { CustomerTable } from "../components/CustomerTable";

/** Props for a CustomerTable showing one already-loaded page, with every handler inert unless overridden. */
export function customerTableProps(overrides: Partial<ComponentProps<typeof CustomerTable>> = {}): ComponentProps<typeof CustomerTable> {
  const customers = overrides.customers ?? [];
  return {
    canWrite: true,
    customers,
    isLoading: false,
    lifecycle: "active",
    onAddCustomer: () => undefined,
    onLifecycleChange: () => undefined,
    onPageChange: () => undefined,
    onPageSizeChange: () => undefined,
    onQueryChange: () => undefined,
    onSelectCustomer: () => undefined,
    page: 1,
    pageSize: 10,
    query: "",
    selectedId: null,
    summary: { activeCustomers: customers.length, archivedCustomers: 0, locations: 0, assets: 0 },
    totalCount: customers.length,
    ...overrides
  };
}
