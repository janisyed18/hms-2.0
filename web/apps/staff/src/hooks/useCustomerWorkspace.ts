import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createHmsClient } from "../api/hmsClient";
import { useActionNotice } from "../components/interaction/ActionNotice";
import { customerLabel } from "../utils/identity";
import type { CustomerFormValues, CustomerRecord } from "../domain/types";

/**
 * `onSelectedChange` lets the owner of the URL decide what selecting (or closing) a customer does;
 * the selection itself then comes back in through `setSelectedId`. Without it the hook keeps its own.
 * `active` is whether the Customers workspace is on screen: each time it becomes so, the asset counts are re-read.
 */
export function useCustomerWorkspace(options: { active?: boolean; onSelectedChange?: (id: string | null) => void } = {}) {
  const { active = false, onSelectedChange } = options;
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

  /**
   * Asset counts live in the customer list, but assets are created, moved and archived elsewhere, so the
   * list read on first load goes stale. Re-reading it replaces each returned customer with the server's
   * current figures; customers read individually (not on the page) and the selection are kept. A failed
   * re-read leaves what is shown as it was.
   */
  const refreshMetrics = useCallback(() => {
    void createHmsClient().listCustomers()
      .then((result) => {
        setCustomers((current) => {
          const fresh = new Map(result.items.map((item) => [item.id, item]));
          const known = new Set(current.map((item) => item.id));
          return [
            ...current.map((item) => fresh.get(item.id) ?? item),
            ...result.items.filter((item) => !known.has(item.id))
          ];
        });
        setTotalCount(result.total);
      })
      .catch(() => undefined);
  }, []);

  // Entering Customers shows the server's current counts, whatever changed them since the last read.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) refreshMetrics();
    wasActive.current = active;
  }, [active, refreshMetrics]);

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
  /** Adds a customer read by id (one that is not on the loaded page) so it can be shown. */
  const addCustomer = useCallback((customer: CustomerRecord) => {
    setCustomers((current) => (current.some((item) => item.id === customer.id) ? current : [customer, ...current]));
  }, []);
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

  return { activeTab, addCustomer, refreshMetrics, dismissNotice, notice, closeDetail, closeCustomerForm, customers, editingCustomer, error, isFormOpen, isLoading, openCreateCustomer, openEditCustomer, query, riskFilter, saveCustomer, selectCustomer, selectedCustomer, setActiveTab, setQuery, setRiskFilter, setSelectedId, setStatusFilter, statusFilter, totalCount, visibleCustomers };
}
