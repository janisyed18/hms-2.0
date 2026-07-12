import { useEffect, useMemo, useState } from "react";

import {
  createHmsClient,
  loadCustomersWithFallback
} from "../api/hmsClient";
import { makeLocalCustomer } from "../data/mockCustomers";
import type {
  CustomerFormValues,
  CustomerRecord,
  DataSource
} from "../domain/types";

export function useCustomerWorkspace() {
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [source, setSource] = useState<DataSource>("mock");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [activeTab, setActiveTab] = useState("Overview");
  const [isFormOpen, setFormOpen] = useState(false);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void loadCustomersWithFallback()
      .then((result) => {
        if (!active) {
          return;
        }
        setCustomers(result.items);
        setTotalCount(result.total);
        setSource(result.source);
        setSelectedId(result.items[0]?.id ?? null);
      })
      .catch(() => {
        if (active) {
          setError("Unable to load customer records from the HMS API.");
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const visibleCustomers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return customers.filter((customer) => {
      const matchesSearch =
        !normalized ||
        [
          customer.name,
          customer.code,
          customer.notes,
          customer.locations[0]?.city,
          customer.locations[0]?.country,
          customer.metrics.inspectionDueLabel
        ]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalized));
      const matchesRisk =
        riskFilter === "All" || customer.riskLevel === riskFilter;
      const matchesStatus =
        statusFilter === "All" || customer.status === statusFilter;
      return matchesSearch && matchesRisk && matchesStatus;
    });
  }, [customers, query, riskFilter, statusFilter]);

  const selectedCustomer =
    customers.find((customer) => customer.id === selectedId) ??
    visibleCustomers[0] ??
    customers[0] ??
    null;

  async function createCustomer(values: CustomerFormValues) {
    let created: CustomerRecord;
    if (source === "api") {
      try {
        created = await createHmsClient().createCustomer(values);
      } catch {
        created = makeLocalCustomer(values);
      }
    } else {
      created = makeLocalCustomer(values);
    }
    setCustomers((current) => [created, ...current]);
    setTotalCount((current) => current + 1);
    setQuery("");
    setRiskFilter("All");
    setStatusFilter("All");
    setSelectedId(created.id);
    setFormOpen(false);
  }

  return {
    activeTab,
    createCustomer,
    customers,
    error,
    isFormOpen,
    isLoading,
    query,
    riskFilter,
    selectedCustomer,
    setActiveTab,
    setFormOpen,
    setQuery,
    setRiskFilter,
    setSelectedId,
    setStatusFilter,
    source,
    statusFilter,
    totalCount,
    visibleCustomers
  };
}
