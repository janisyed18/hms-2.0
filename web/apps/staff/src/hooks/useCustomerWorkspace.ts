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
  const [editingCustomer, setEditingCustomer] = useState<CustomerRecord | null>(null);
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

  const selectedCustomer = selectedId
    ? customers.find((customer) => customer.id === selectedId) ?? null
    : null;

  function closeDetail() {
    setSelectedId(null);
  }

  function closeCustomerForm() {
    setEditingCustomer(null);
    setFormOpen(false);
  }

  function openCreateCustomer() {
    setEditingCustomer(null);
    setFormOpen(true);
  }

  function openEditCustomer(customer: CustomerRecord) {
    setEditingCustomer(customer);
    setFormOpen(true);
  }

  function selectCustomer(id: string) {
    setSelectedId(id);
    setActiveTab("Overview");
  }

  async function saveCustomer(values: CustomerFormValues) {
    let saved: CustomerRecord;
    if (source === "api") {
      saved = editingCustomer
        ? await createHmsClient().updateCustomer(editingCustomer.id, values, editingCustomer.etag)
        : await createHmsClient().createCustomer(values);
    } else {
      saved = editingCustomer
        ? {
            ...makeLocalCustomer(values),
            id: editingCustomer.id,
            code: editingCustomer.code,
            etag: editingCustomer.etag,
            metrics: editingCustomer.metrics,
            status: editingCustomer.status,
            riskLevel: editingCustomer.riskLevel,
            industry: editingCustomer.industry,
            paymentTerms: editingCustomer.paymentTerms,
            contractStart: editingCustomer.contractStart,
            contractEnd: editingCustomer.contractEnd,
            lastActivity: "Just now"
          }
        : makeLocalCustomer(values);
    }
    setCustomers((current) => editingCustomer
      ? current.map((customer) => customer.id === saved.id ? saved : customer)
      : [saved, ...current]);
    if (!editingCustomer) {
      setTotalCount((current) => current + 1);
    }
    setQuery("");
    setRiskFilter("All");
    setStatusFilter("All");
    setSelectedId(saved.id);
    closeCustomerForm();
  }

  return {
    activeTab,
    closeDetail,
    closeCustomerForm,
    customers,
    editingCustomer,
    error,
    isFormOpen,
    isLoading,
    openCreateCustomer,
    openEditCustomer,
    query,
    riskFilter,
    saveCustomer,
    selectCustomer,
    selectedCustomer,
    setActiveTab,
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
