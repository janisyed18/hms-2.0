import { useEffect, useMemo, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import { useActionNotice } from "../components/interaction/ActionNotice";
import { customerLabel } from "../utils/identity";
import type { CustomerFormValues, CustomerRecord } from "../domain/types";

/**
 * `onSelectedChange` lets the owner of the URL decide what selecting (or closing) a customer does;
 * the selection itself then comes back in through `setSelectedId`. Without it the hook keeps its own.
 */
export function useCustomerWorkspace(options: { onSelectedChange?: (id: string | null) => void } = {}) {
  const { onSelectedChange } = options;
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [activeTab, setActiveTab] = useState("Locations");
  const [isFormOpen, setFormOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<CustomerRecord | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { notice, notify, clear: dismissNotice } = useActionNotice();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const client = createHmsClient();
    void client.listCustomers()
      .then((result) => {
        if (!active) return;
        // Asset counts come from the API (aggregated per customer), never from a
        // client-side tally of some page of assets.
        setCustomers(result.items);
        setTotalCount(result.total);
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

  function select(id: string | null) { if (onSelectedChange) onSelectedChange(id); else setSelectedId(id); }
  function closeDetail() { select(null); }
  function closeCustomerForm() { setEditingCustomer(null); setFormOpen(false); }
  function openCreateCustomer() { setEditingCustomer(null); setFormOpen(true); }
  function openEditCustomer(customer: CustomerRecord) { setEditingCustomer(customer); setFormOpen(true); }
  function selectCustomer(id: string) { select(id); setActiveTab("Locations"); }

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
    select(saved.id);
    closeCustomerForm();
    notify({ kind: "success", message: `${customerLabel(saved)} ${editingCustomer ? "updated" : "created"} successfully.`, title: "Customer saved" });
  }

  return { activeTab, dismissNotice, notice, closeDetail, closeCustomerForm, customers, editingCustomer, error, isFormOpen, isLoading, openCreateCustomer, openEditCustomer, query, riskFilter, saveCustomer, selectCustomer, selectedCustomer, setActiveTab, setQuery, setRiskFilter, setSelectedId, setStatusFilter, statusFilter, totalCount, visibleCustomers };
}
