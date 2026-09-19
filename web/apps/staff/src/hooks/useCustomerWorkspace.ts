import { useEffect, useMemo, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import type { CustomerFormValues, CustomerRecord } from "../domain/types";

export function useCustomerWorkspace() {
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
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
    const client = createHmsClient();
    void Promise.all([
      client.listCustomers(),
      client.listAssets({ limit: 100 }).catch(() => null)
    ])
      .then(([result, assetResult]) => {
        if (!active) return;
        const assetCounts = new Map<string, number>();
        assetResult?.items.forEach((asset) => {
          assetCounts.set(asset.customer.id, (assetCounts.get(asset.customer.id) ?? 0) + 1);
        });
        setCustomers(result.items.map((customer) => ({
          ...customer,
          metrics: {
            ...customer.metrics,
            assetCount: assetResult ? assetCounts.get(customer.id) ?? 0 : customer.metrics.assetCount
          }
        })));
        setTotalCount(result.total);
        setSelectedId(null);
      })
      .catch(() => {
        if (active) setError("Unable to load customer records from the HMS API.");
      })
      .finally(() => {
        if (active) setLoading(false);
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
        [customer.name, customer.code, customer.notes, customer.locations[0]?.city, customer.locations[0]?.country]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalized));
      return (
        matchesSearch &&
        (riskFilter === "All" || customer.riskLevel === riskFilter) &&
        (statusFilter === "All" || customer.status === statusFilter)
      );
    });
  }, [customers, query, riskFilter, statusFilter]);

  const selectedCustomer = selectedId
    ? customers.find((customer) => customer.id === selectedId) ?? null
    : null;

  function closeDetail() { setSelectedId(null); }
  function closeCustomerForm() { setEditingCustomer(null); setFormOpen(false); }
  function openCreateCustomer() { setEditingCustomer(null); setFormOpen(true); }
  function openEditCustomer(customer: CustomerRecord) { setEditingCustomer(customer); setFormOpen(true); }
  function selectCustomer(id: string) { setSelectedId(id); setActiveTab("Overview"); }

  async function saveCustomer(values: CustomerFormValues) {
    const client = createHmsClient();
    const saved = editingCustomer
      ? await client.updateCustomer(editingCustomer.id, values, editingCustomer.etag)
      : await client.createCustomer(values);
    setCustomers((current) => editingCustomer
      ? current.map((customer) => customer.id === saved.id ? saved : customer)
      : [saved, ...current]);
    if (!editingCustomer) setTotalCount((current) => current + 1);
    setQuery("");
    setRiskFilter("All");
    setStatusFilter("All");
    setSelectedId(saved.id);
    closeCustomerForm();
  }

  return { activeTab, closeDetail, closeCustomerForm, customers, editingCustomer, error, isFormOpen, isLoading, openCreateCustomer, openEditCustomer, query, riskFilter, saveCustomer, selectCustomer, selectedCustomer, setActiveTab, setQuery, setRiskFilter, setSelectedId, setStatusFilter, statusFilter, totalCount, visibleCustomers };
}
